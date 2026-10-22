# Security / 安全

## Reporting / 报告漏洞

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") on this repository.

请不要在公开 issue 里报告安全问题，请用本仓库 Security 页的「Report a vulnerability」私下提交。

## How secrets are handled / 密钥如何保存

- API keys (Doubao, Vidu, optional RTC AppKey) are entered in the app and encrypted with Electron `safeStorage` (macOS Keychain). They live only in `~/Library/Application Support/annie-lite` and never in this repository.
- Smoke scripts under `tests/smoke/` read keys from environment variables (e.g. `DOUBAO_KEY`); never hard-code them.
- Standby audio for wake-word detection is processed on-device and is not uploaded before the wake word is detected.
- Destructive tools require confirmation by default; memory writes reject content that looks like secrets or prompt injection.

If you accidentally commit a key, revoke it at the provider immediately; deleting the commit is not enough.
