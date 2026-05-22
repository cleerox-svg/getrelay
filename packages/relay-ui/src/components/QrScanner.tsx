import { useEffect, useRef, useState } from 'react';

type Props = {
  onDecode: (raw: string) => void;
  onClose: () => void;
};

// Full-screen overlay that opens the rear camera, runs jsQR on each
// frame, and fires `onDecode` with the first successful read. jsQR is
// dynamic-imported so the ~14KB wasm-free decoder only ships when the
// scanner actually opens (not on app boot).
export function QrScanner({ onDecode, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const decodedRef = useRef(false);
  const [status, setStatus] = useState<'init' | 'scanning' | 'error'>('init');
  const [errorMsg, setErrorMsg] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    let jsQR: typeof import('jsqr').default | null = null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    async function start() {
      try {
        const mod = await import('jsqr');
        jsQR = mod.default;
        if (cancelled) return;

        if (!navigator.mediaDevices?.getUserMedia) {
          setStatus('error');
          setErrorMsg('Camera not supported in this browser.');
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        await video.play();
        setStatus('scanning');
        tick();
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        const name = (err as { name?: string })?.name ?? '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setErrorMsg('Camera permission denied. Allow access in settings, then try again.');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setErrorMsg('No camera found on this device.');
        } else {
          setErrorMsg('Could not start the camera.');
        }
      }
    }

    function tick() {
      if (cancelled || decodedRef.current) return;
      const video = videoRef.current;
      if (!video || !ctx || !jsQR) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w > 0 && h > 0) {
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code?.data) {
            decodedRef.current = true;
            onDecode(code.data);
            return;
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    start();

    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      const stream = streamRef.current;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [onDecode]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px',
          color: '#fff',
          background: 'rgba(0,0,0,0.5)',
        }}
      >
        <span style={{ fontSize: 17, fontWeight: 600 }}>Scan QR code</span>
        <button
          onClick={onClose}
          aria-label="Close scanner"
          style={{
            background: 'transparent',
            color: '#fff',
            border: 'none',
            fontSize: 17,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>

      <div
        style={{
          flex: 1,
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: status === 'scanning' ? 'block' : 'none',
          }}
        />
        {status === 'scanning' ? (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              width: 'min(70vw, 280px)',
              aspectRatio: '1 / 1',
              border: '2px solid rgba(255,255,255,0.85)',
              borderRadius: 12,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
            }}
          />
        ) : null}
        {status === 'init' ? (
          <div style={{ color: '#fff', fontSize: 15 }}>Requesting camera access…</div>
        ) : null}
        {status === 'error' ? (
          <div
            style={{
              color: '#fff',
              fontSize: 15,
              padding: 24,
              textAlign: 'center',
              maxWidth: 320,
            }}
          >
            {errorMsg}
          </div>
        ) : null}
      </div>

      {status === 'scanning' ? (
        <div
          style={{
            padding: '16px 24px 28px',
            color: 'rgba(255,255,255,0.85)',
            fontSize: 14,
            textAlign: 'center',
            background: 'rgba(0,0,0,0.5)',
          }}
        >
          Point the camera at a Relay QR code.
        </div>
      ) : null}
    </div>
  );
}
