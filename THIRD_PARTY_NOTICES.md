# Third-party notices

Honey's first-party license is [PolyForm Noncommercial 1.0.0](LICENSE).
Third-party components retain their upstream terms; the root license does not
replace or restrict rights granted by those licenses.

## Source notices present in this repository

| Source | Notice | Scope |
| --- | --- | --- |
| Deck scaffold | [deck/LICENSE](deck/LICENSE), MIT, copyright 2026 StackBlitz | Preserve the original notice for the scaffold/source it covers. Honey's presentation content is not claimed to be authored by StackBlitz. |
| Liquid UI | [apps/web/src/components/liquid/LICENSE](apps/web/src/components/liquid/LICENSE), MIT, copyright 2026 Vivek Sahu | Preserve the original notice with the copied component source. |

These existing notices establish third-party material in the tree; the README
therefore does not claim that no template or borrowed source was used. This is
an inventory of the local notices found, not a legal opinion or a complete
dependency-license audit.

## Package dependencies and assets

The exact JS and Rust dependency versions are in `pnpm-lock.yaml` and `Cargo.lock`.
Their packages include their own license files/notices. Expo/React Native,
Next.js/React, axum/tokio, WalletConnect/Reown, Firebase, viem, Noble/Scure and
other dependencies are dependencies, not code authored by Honey.

Token, protocol and provider names/logos identify their respective projects.
Do not interpret bundled branding as endorsement or as a grant of trademark
rights. Confirm the provenance of custom artwork, fonts and externally copied
assets before publication; this inventory does not establish ownership of them.

The existing contributor agreement remains [CLA.md](CLA.md). Relicensing any
first-party work requires the appropriate rights; eligibility for this hackathon
does not itself transfer copyright or require an MIT conversion.
