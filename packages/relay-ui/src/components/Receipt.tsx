interface Props {
  delivered: boolean;
  read: boolean;
  // Group-only counts. When totalRecipients is undefined we render
  // the 1to1 / recipient-view path (one check = delivered, two = read).
  // When defined we render BBM-style: gray glyph for "some recipients
  // have acked", colored glyph for "all".
  deliveredCount?: number;
  readCount?: number;
  totalRecipients?: number;
  onAccent?: boolean; // when rendered on an iOS-blue bubble
}

// Single check for delivered, double check for read. Both green when
// active; gray when partial or inactive. Inspired by WhatsApp's group
// semantics (everyone's seen it → colored).
export function Receipt({
  delivered,
  read,
  deliveredCount,
  readCount,
  totalRecipients,
  onAccent = false,
}: Props) {
  const inactive = onAccent ? 'rgba(255,255,255,0.45)' : '#C7C7CC';
  const active = '#34C759'; // iOS systemGreen
  const dimDelivered = onAccent ? '#FFFFFF' : '#8E8E93';

  // Group-aware: "all delivered" means every receipt row has a
  // delivered_at; "all read" means every row has a read_at. For 1to1
  // (no counts), fall back to the booleans where any === all.
  const allDelivered =
    totalRecipients === undefined
      ? delivered
      : (deliveredCount ?? 0) >= totalRecipients;
  const allRead =
    totalRecipients === undefined
      ? read
      : (readCount ?? 0) >= totalRecipients;
  // Partial states only exist for groups. "partial delivered" =
  // someone has it but not everyone; "partial read" = someone read
  // but not everyone (and not yet "all read").
  const partialDelivered =
    totalRecipients !== undefined &&
    (deliveredCount ?? 0) > 0 &&
    !allDelivered;
  const partialRead =
    totalRecipients !== undefined && (readCount ?? 0) > 0 && !allRead;

  // First check: shown for any-delivered (anyone has it). Colored
  // when all delivered, gray when only some.
  const showFirstCheck = delivered;
  const firstColor = allDelivered ? (onAccent ? '#FFFFFF' : active) : dimDelivered;

  // Second check: shown for any-read. Colored when all read, gray
  // when only some have read (overlays the first check).
  const showSecondCheck = read || partialRead;
  const secondColor = allRead ? active : dimDelivered;

  return (
    <span
      aria-label={
        allRead
          ? 'read by all'
          : partialRead
            ? 'read by some'
            : allDelivered
              ? 'delivered'
              : partialDelivered
                ? 'delivered to some'
                : delivered
                  ? 'delivered'
                  : 'pending'
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        color: showFirstCheck ? firstColor : inactive,
        marginLeft: 2,
      }}
    >
      <svg width="16" height="11" viewBox="0 0 16 11" fill="none" aria-hidden="true">
        {/* First check — always rendered (use color to express state) */}
        <path
          d="M1 6 L4.5 9.5 L11 2.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Second check overlays once anyone has read */}
        {showSecondCheck ? (
          <path
            d="M5.5 6 L9 9.5 L15.5 2.5"
            stroke={secondColor}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ) : null}
      </svg>
    </span>
  );
}
