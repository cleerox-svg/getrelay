// Brand badge for the Konsta Navbar `title` slot on tabbed routes:
// logo + "Relay" + small "Pin to Pin Messenger" tagline.
export function BrandTitle() {
  return (
    <span className="inline-flex items-center gap-2 leading-none">
      <img src="/favicon.svg" alt="" width={22} height={22} />
      <span className="flex flex-col items-start leading-none">
        <span className="text-[15px] font-semibold leading-none">Relay</span>
        <span
          className="text-[10px] leading-none mt-0.5"
          style={{ color: 'var(--text-dim)' }}
        >
          Pin to Pin Messenger
        </span>
      </span>
    </span>
  );
}
