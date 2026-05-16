# PWA Icons

Required PNGs (replace these placeholders before launch):

- `icon-192.png` (192×192)
- `icon-512.png` (512×512)
- `icon-maskable-192.png` (192×192, with safe-area padding)
- `icon-maskable-512.png` (512×512, with safe-area padding)
- `apple-touch-icon.png` (180×180)
- `apple-touch-icon-152.png` (152×152)
- `apple-touch-icon-180.png` (180×180)

Quick generation from `favicon.svg` (using ImageMagick):

```bash
for size in 152 180 192 512; do
  convert -background "#0b3a66" -resize ${size}x${size} ../favicon.svg icon-${size}.png
done
```

For maskable icons add ~10% safe-area padding around the artwork.
