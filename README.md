# CO3 ECH Edition

CO3 ECH Edition is an Android reader for [Archive of Our Own (AO3)](https://archiveofourown.org/), maintained in this repository for users who need protected AO3 connectivity.

This repository is based on the upstream CO3 project and contains the current ECH/DoH-enabled Android work, including the reader, local library, bookmarks, offline chapters, and direct file export.

## Current Build

- Android architecture: `arm64-v8a`
- Latest stable release: [CO3 ECH 下载与图片速度修复](https://github.com/anglesgirl/CO3/releases/tag/ech-download-image-speed-fix-d3d8776)
- Build workflow: [Android ECH build](https://github.com/anglesgirl/CO3/actions/workflows/android-ech.yml)
- Download delivery: the Release page provides the APK, an installation ZIP, and SHA-256 checksums

Download the ZIP from Releases, extract the APK, and install it on an Android arm64 device. Telegram delivery uses the ZIP because APK files are restricted by the delivery channel.

## Main Features

- AO3 login with either username or email
- Canonical AO3 username resolution for profile and bookmark routes
- Library, categories, reading history, and progress tracking
- Offline chapter downloads stored in app-private storage
- Downloaded chapter status reconciliation and visible failure reasons
- Native AO3 work export as `EPUB`, `PDF`, `MOBI`, `AZW3`, or `HTML`
- Reader image routing through the local ECH proxy
- Cloudflare Zero Trust DoH failover and configured Cloudflare edge IPs
- ECH status and protected connection diagnostics
- Chapter-opening loading lock to prevent duplicate reader pages from repeated taps
- No subscription and no advertising added by this repository

## ECH / DoH

The Android build routes protected AO3 requests through the bundled local proxy. The proxy obtains ECH configuration through the configured remote TXT record and uses the configured Cloudflare DoH endpoints with failover.

ECH is used to protect the AO3 connection. It does not make the outer SNI an arbitrary website name; the deployed ECH configuration and its public name must match the server configuration.

The ECH configuration domain and DoH settings are managed in the app's ECH preferences. Do not put private Zero Trust credentials or tokens in this repository.

## Verification

The current release was built by GitHub Actions for `arm64-v8a`. The focused JavaScript regression suite for the current fixes passed with 4 suites and 21 tests. Release checksums are published in `SHA256SUMS.txt`.

## Important Limitations

- This build is currently intended for Android arm64 devices.
- AO3 availability, rate limiting, Cloudflare challenges, and ECH support can vary by network.
- If a download displays an error icon, tap it again to view the recorded failure reason.
- Database and file export use Android's public Downloads integration; Android may still apply device-specific storage policies.
- iOS is not the target of the ECH work in this repository and is not included in the current release process.

## Development

Large Android, Go, and NDK builds are run in GitHub Actions. The local JavaScript regression command is:

```bash
npm test -- --runInBand --config jest.features.config.js
```

The ECH proxy and Android release workflow is defined in `.github/workflows/android-ech.yml`.

## Upstream

The upstream project is [tbvns/CO3](https://github.com/tbvns/CO3). This repository keeps its own build, release, and ECH-specific documentation so that installation and behavior match the binaries published here.

## License

The project remains licensed under the GNU General Public License as described in [LICENSE](LICENSE). Upstream name, logo, and branding terms remain applicable to the original project.
