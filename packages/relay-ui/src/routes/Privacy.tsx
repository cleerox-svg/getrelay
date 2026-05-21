import { Link } from 'react-router-dom';

// Static privacy policy. Linked from Profile, the Play Store listing,
// and the Sign-in page. Public route — no auth required.

const EFFECTIVE_DATE = 'May 21, 2026';

export function Privacy() {
  return (
    <div
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: 'calc(env(safe-area-inset-top, 0px) + 24px) 20px 64px',
        color: 'var(--text)',
        fontSize: 15,
        lineHeight: 1.55,
      }}
    >
      <Link to="/" style={{ color: 'var(--accent)', fontSize: 14 }}>
        ← Back to Relay
      </Link>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginTop: 16 }}>Privacy Policy</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
        Effective {EFFECTIVE_DATE}
      </p>

      <p style={{ marginTop: 16 }}>
        Relay is a pin-to-pin messenger built by Averrow. This policy explains
        what data we collect, why we collect it, and what we do with it.
        Relay is currently in private beta — the policy may change as we
        approach 1.0, and we'll update the effective date when it does.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 28 }}>
        Information we collect
      </h2>
      <ul style={{ paddingLeft: 20, marginTop: 8 }}>
        <li>
          <strong>Account.</strong> When you sign in with Google we receive
          your email address, name, and a stable Google account identifier.
          We use these to create your Relay account.
        </li>
        <li>
          <strong>Profile.</strong> Your display name, status message, avatar,
          and the PIN we generate are stored against your account.
        </li>
        <li>
          <strong>Messages and media.</strong> Messages, photos, and videos
          you send through Relay are stored on our servers so they can be
          delivered to your recipient and re-loaded when you re-open the
          app. They are encrypted in transit (HTTPS / WSS) but, at the time
          of writing, are not end-to-end encrypted at rest.
        </li>
        <li>
          <strong>Push subscriptions.</strong> If you enable notifications,
          we store the push endpoint and keys your browser/device gives us
          so we can deliver notifications.
        </li>
        <li>
          <strong>Operational logs.</strong> Standard request logs (timestamp,
          IP-derived country, error codes). We do not store full IP addresses.
        </li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 28 }}>
        How we use information
      </h2>
      <ul style={{ paddingLeft: 20, marginTop: 8 }}>
        <li>To run the messaging service end-to-end.</li>
        <li>To deliver push notifications you opt into.</li>
        <li>To investigate abuse or operational issues.</li>
        <li>
          To show sports score notifications you opt into (Canadiens, Blue
          Jays) — we hit the public NHL and MLB APIs, no personal data is
          sent to them.
        </li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 28 }}>
        What we don't do
      </h2>
      <ul style={{ paddingLeft: 20, marginTop: 8 }}>
        <li>We do not sell your data.</li>
        <li>We do not share your data with advertisers.</li>
        <li>We do not run any AI/ML models against your messages or media.</li>
        <li>We do not read your messages.</li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 28 }}>
        Who can see what
      </h2>
      <p>
        Only the participants of a chat can see that chat's contents. Server
        operators can technically access stored messages (they're not E2E
        encrypted yet), but we don't, except where strictly necessary for a
        bug investigation you have asked us to help with.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 28 }}>
        Data retention
      </h2>
      <ul style={{ paddingLeft: 20, marginTop: 8 }}>
        <li>
          <strong>Messages.</strong> Kept until you delete the chat
          (long-press → Delete) or close your account.
        </li>
        <li>
          <strong>Media (photos/videos).</strong> Same lifetime as the
          message that references them.
        </li>
        <li>
          <strong>Account data.</strong> Kept until you ask us to delete
          it. Email <code>cleerox@gmail.com</code> for deletion requests
          while we build a self-serve flow.
        </li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 28 }}>
        Children
      </h2>
      <p>
        Relay isn't designed for children under 13. If you believe a
        child has signed up, contact us and we'll delete the account.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 28 }}>
        Third parties
      </h2>
      <ul style={{ paddingLeft: 20, marginTop: 8 }}>
        <li>
          <strong>Google Sign-In</strong> — for authentication only.
        </li>
        <li>
          <strong>Cloudflare</strong> — hosts the worker, the web app, the
          database (D1), object storage (R2), and the WebSocket service. All
          data lives in Cloudflare's North American regions.
        </li>
        <li>
          <strong>Browser push gateways</strong> (Apple APNs, Google FCM,
          Mozilla autopush) — used to deliver notifications you opt into.
        </li>
        <li>
          <strong>NHL.com and MLB.com</strong> public APIs — for sports
          score notifications you opt into. No personal data is sent.
        </li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 28 }}>
        Your rights
      </h2>
      <p>
        You can export, correct, or delete your data by emailing{' '}
        <a href="mailto:cleerox@gmail.com" style={{ color: 'var(--accent)' }}>
          cleerox@gmail.com
        </a>
        . If you're in a jurisdiction that grants additional rights (GDPR in
        the EU/UK, PIPEDA in Canada, CCPA in California), those rights apply
        too — same address.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 28 }}>
        Contact
      </h2>
      <p>
        Questions or concerns? Email{' '}
        <a href="mailto:cleerox@gmail.com" style={{ color: 'var(--accent)' }}>
          cleerox@gmail.com
        </a>
        .
      </p>

      <p style={{ marginTop: 32, color: 'var(--text-dim)', fontSize: 13 }}>
        — Relay by Averrow
      </p>
    </div>
  );
}
