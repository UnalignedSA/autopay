//! Solana: SOL, or an SPL token (classic or Token-2022).

use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use solana_commitment_config::CommitmentConfig;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signature, Signer};
use solana_sdk::transaction::Transaction;
use spl_associated_token_account_interface::address::get_associated_token_address_with_program_id;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;
use spl_token_2022_interface::extension::StateWithExtensions;
use spl_token_2022_interface::state::Mint;

use super::Payer;
use crate::amounts::to_base_units_u64;
use crate::config::{ConfigError, native_coin};

const SOL_DECIMALS: u32 = 9;
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(90);
const CONFIRM_POLL: Duration = Duration::from_millis(500);

fn mint_table(coin: &str) -> Option<&'static str> {
    match coin {
        "USDT" => Some("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
        "USDC" => Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
        _ => None,
    }
}

/// The two programs a mint can belong to.
fn is_token_program(program: &Pubkey) -> bool {
    *program == spl_token_2022_interface::id() || *program == spl_token_2022_interface::inline_spl_token::id()
}

/// A base58 secret key, or the JSON byte array that solana-keygen writes. The public half must match.
pub fn parse_solana_key(text: &str) -> Result<Keypair, ConfigError> {
    let text = text.trim();
    let not_a_key = || ConfigError("SOLANA_PRIVATE_KEY is neither a base58 secret key nor a JSON byte array".into());
    let bytes: Vec<u8> = if text.starts_with('[') {
        serde_json::from_str(text).map_err(|_| not_a_key())?
    } else {
        bs58::decode(text).into_vec().map_err(|_| not_a_key())?
    };
    if bytes.len() != 64 {
        return Err(ConfigError("SOLANA_PRIVATE_KEY must hold a 64-byte secret key".into()));
    }
    Keypair::try_from(bytes.as_slice())
        .map_err(|_| ConfigError("SOLANA_PRIVATE_KEY is not a valid secret key: the public half does not match".into()))
}

pub struct SolanaPayer {
    keypair: Keypair,
    client: RpcClient,
    token_address: Option<String>,
}

impl SolanaPayer {
    pub fn new(rpc_url: &str, private_key: &str, token_address: Option<String>) -> Result<Self, ConfigError> {
        let keypair = parse_solana_key(private_key)?;
        let client = RpcClient::new_with_commitment(rpc_url.to_string(), CommitmentConfig::confirmed());
        Ok(SolanaPayer {
            keypair,
            client,
            token_address,
        })
    }

    /// The mint for a coin: `None` for SOL, an error for an unknown token.
    pub fn mint_for(&self, coin: &str) -> anyhow::Result<Option<&str>> {
        if native_coin("solana") == Some(coin) {
            return Ok(None);
        }
        match self.token_address.as_deref().or_else(|| mint_table(coin)) {
            Some(mint) => Ok(Some(mint)),
            None => bail!("no token mint known for {coin} on solana: set TOKEN_ADDRESS"),
        }
    }

    /// Reads the mint on chain: its program (which must be a token program) and its decimals.
    async fn read_mint(&self, mint: &Pubkey) -> anyhow::Result<(Pubkey, u8)> {
        let account = self
            .client
            .get_account(mint)
            .await
            .with_context(|| format!("token mint {mint} not found"))?;
        if !is_token_program(&account.owner) {
            bail!("{mint} is not a token mint: it belongs to {}", account.owner);
        }
        let state = StateWithExtensions::<Mint>::unpack(&account.data)
            .map_err(|_| anyhow!("{mint} is not an initialized token mint"))?;
        Ok((account.owner, state.base.decimals))
    }

    /// Polls the signature until `confirmed` (or `finalized`), a failure, or the timeout. RPC errors on the way
    /// are retried: the transaction is out, only its status is missing.
    async fn wait_confirmed(&self, signature: &Signature) -> anyhow::Result<()> {
        let deadline = tokio::time::Instant::now() + CONFIRM_TIMEOUT;
        let mut last_error = None;
        loop {
            match self
                .client
                .get_signature_status_with_commitment(signature, CommitmentConfig::confirmed())
                .await
            {
                Ok(Some(Ok(()))) => return Ok(()),
                Ok(Some(Err(err))) => bail!("transaction {signature} failed: {err}"),
                Ok(None) => {}
                Err(err) => last_error = Some(err),
            }
            if tokio::time::Instant::now() >= deadline {
                let why = last_error.map(|e| format!(" (last error: {e})")).unwrap_or_default();
                bail!("{signature} not confirmed after {}s{why}", CONFIRM_TIMEOUT.as_secs());
            }
            tokio::time::sleep(CONFIRM_POLL).await;
        }
    }
}

/// "Create the recipient's token account if it is missing" then "transfer checked", for either token program.
fn token_transfer(
    owner: &Pubkey,
    recipient: &Pubkey,
    mint: &Pubkey,
    program: &Pubkey,
    units: u64,
    decimals: u8,
) -> anyhow::Result<[Instruction; 2]> {
    let from = get_associated_token_address_with_program_id(owner, mint, program);
    let dest = get_associated_token_address_with_program_id(recipient, mint, program);
    let create = create_associated_token_account_idempotent(owner, recipient, mint, program);
    let transfer = spl_token_2022_interface::instruction::transfer_checked(
        program,
        &from,
        mint,
        &dest,
        owner,
        &[],
        units,
        decimals,
    )?;
    Ok([create, transfer])
}

#[async_trait]
impl Payer for SolanaPayer {
    async fn address(&self) -> anyhow::Result<String> {
        Ok(self.keypair.pubkey().to_string())
    }

    /// Pays SOL, or a token to the recipient's associated token account (created first, idempotently, in the
    /// same transaction). Waits for the `confirmed` commitment and returns the signature.
    async fn send(&self, to: &str, coin: &str, amount: &str) -> anyhow::Result<String> {
        let recipient = Pubkey::from_str(to).map_err(|_| anyhow!("{to:?} is not a Solana address"))?;
        let owner = self.keypair.pubkey();

        let instructions = match self.mint_for(coin)? {
            None => {
                let lamports = to_base_units_u64(amount, SOL_DECIMALS)?;
                vec![solana_system_interface::instruction::transfer(
                    &owner, &recipient, lamports,
                )]
            }
            Some(mint) => {
                let mint = Pubkey::from_str(mint).map_err(|_| anyhow!("{mint:?} is not a Solana mint address"))?;
                let (program, decimals) = self.read_mint(&mint).await?;
                let units = to_base_units_u64(amount, decimals.into())?;
                token_transfer(&owner, &recipient, &mint, &program, units, decimals)?.to_vec()
            }
        };

        let blockhash = self.client.get_latest_blockhash().await.context("Solana RPC")?;
        let tx = Transaction::new_signed_with_payer(&instructions, Some(&owner), &[&self.keypair], blockhash);
        let signature = self
            .client
            .send_transaction(&tx)
            .await
            .context("sending the transaction")?;
        self.wait_confirmed(&signature).await?;
        Ok(signature.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OVERRIDE: &str = "0x1111111111111111111111111111111111111111";

    fn key_json() -> String {
        serde_json::to_string(&Keypair::new().to_bytes().to_vec()).unwrap()
    }

    #[test]
    fn sol_is_native_even_with_token_address_an_unknown_coin_fails() {
        let key = key_json();
        let sol = SolanaPayer::new("http://127.0.0.1:1", &key, Some(OVERRIDE.into())).unwrap();
        assert_eq!(sol.mint_for("SOL").unwrap(), None);
        assert_eq!(sol.mint_for("USDT").unwrap(), Some(OVERRIDE));
        let plain = SolanaPayer::new("http://127.0.0.1:1", &key, None).unwrap();
        assert_eq!(
            plain.mint_for("USDC").unwrap(),
            Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
        );
        assert!(plain.mint_for("DAI").unwrap_err().to_string().contains("TOKEN_ADDRESS"));
    }

    #[test]
    fn the_key_is_a_base58_secret_key_or_a_json_byte_array() {
        let keypair = Keypair::new();
        let bytes = keypair.to_bytes();
        let from_json = parse_solana_key(&serde_json::to_string(&bytes.to_vec()).unwrap()).unwrap();
        assert_eq!(from_json.to_bytes(), bytes);
        let from_base58 = parse_solana_key(&bs58::encode(bytes).into_string()).unwrap();
        assert_eq!(from_base58.pubkey(), keypair.pubkey());
        assert!(parse_solana_key("not a key!").is_err());
        assert!(parse_solana_key("[1,2,3]").is_err());
        // 64 bytes whose second half is not the public key of the first.
        let wrong: Vec<u8> = (1..=64).collect();
        assert!(
            parse_solana_key(&serde_json::to_string(&wrong).unwrap())
                .unwrap_err()
                .0
                .contains("public half")
        );
    }

    #[test]
    fn only_the_two_token_programs_own_mints() {
        let classic = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
        let token_2022 = Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap();
        assert!(is_token_program(&classic));
        assert!(is_token_program(&token_2022));
        assert!(!is_token_program(&solana_system_interface::program::id()));
    }

    #[test]
    fn the_token_transfer_targets_the_mints_program_with_the_right_layout() {
        let owner = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let ata_program = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap();
        for program in [
            spl_token_2022_interface::id(),
            spl_token_2022_interface::inline_spl_token::id(),
        ] {
            let [create, transfer] = token_transfer(&owner, &recipient, &mint, &program, 5_250_000, 6).unwrap();
            let from = get_associated_token_address_with_program_id(&owner, &mint, &program);
            let dest = get_associated_token_address_with_program_id(&recipient, &mint, &program);

            // Associated token account program, instruction 1 = CreateIdempotent.
            assert_eq!(create.program_id, ata_program);
            assert_eq!(create.data, vec![1]);
            let keys: Vec<Pubkey> = create.accounts.iter().map(|a| a.pubkey).collect();
            assert_eq!(
                keys,
                vec![
                    owner,
                    dest,
                    recipient,
                    mint,
                    solana_system_interface::program::id(),
                    program
                ]
            );
            assert!(create.accounts[0].is_signer && create.accounts[0].is_writable);

            // Token program, instruction 12 = TransferChecked: amount (u64 little endian), then decimals.
            assert_eq!(transfer.program_id, program);
            let mut data = vec![12];
            data.extend_from_slice(&5_250_000u64.to_le_bytes());
            data.push(6);
            assert_eq!(transfer.data, data);
            let metas: Vec<(Pubkey, bool, bool)> = transfer
                .accounts
                .iter()
                .map(|a| (a.pubkey, a.is_signer, a.is_writable))
                .collect();
            assert_eq!(
                metas,
                vec![
                    (from, false, true),
                    (mint, false, false),
                    (dest, false, true),
                    (owner, true, false)
                ]
            );
        }
    }
}
