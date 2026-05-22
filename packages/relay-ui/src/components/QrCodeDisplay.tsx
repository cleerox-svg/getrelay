import { QRCodeSVG } from 'qrcode.react';
import { pinShareUrl } from '../lib/pin';

export function QrCodeDisplay({ pin, size = 220 }: { pin: string; size?: number }) {
  const url = pinShareUrl(pin);
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        padding: 16,
        background: '#ffffff',
        borderRadius: 12,
      }}
    >
      <QRCodeSVG
        value={url}
        size={size}
        level="M"
        bgColor="#ffffff"
        fgColor="#000000"
        marginSize={0}
      />
    </div>
  );
}
