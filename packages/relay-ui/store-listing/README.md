# Google Play store listing assets

All assets here are generated from the SVG sources in this folder by
`scripts/build-store-assets.mjs`. Run `pnpm store-assets` to regenerate.

The actual app icon (separate from the feature graphic) is
`../public/icon-512.png`.

## What goes where in Play Console

App Console → **Main store listing**:

| Play Console slot | File |
|---|---|
| App icon (512×512) | `../public/icon-512.png` |
| Feature graphic (1024×500) | `feature-graphic.png` |
| Phone screenshots (2–8) | everything under `phone/` |
| 7-inch tablet screenshots | everything under `tablet-7/` |
| 10-inch tablet screenshots | everything under `tablet-10/` |

Upload in numeric order (screenshot-1 first) so the listing carousel
opens on the Chats screen.

## Text copy

App name, short description, full description — see the message in the
PR that introduced these assets, or paste from `LISTING-COPY.md` (a
copy lives in this folder).
