/** Small "verified" seal shown next to a tutor's name. */
export function VerifiedBadge({ size = 16 }: { size?: number }) {
  return (
    <svg className="verified-badge" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Verified tutor">
      <title>Verified tutor</title>
      <polygon points="12.00,0.50 14.48,2.73 17.75,2.04 18.79,5.21 21.96,6.25 21.27,9.52 23.50,12.00 21.27,14.48 21.96,17.75 18.79,18.79 17.75,21.96 14.48,21.27 12.00,23.50 9.52,21.27 6.25,21.96 5.21,18.79 2.04,17.75 2.73,14.48 0.50,12.00 2.73,9.52 2.04,6.25 5.21,5.21 6.25,2.04 9.52,2.73" fill="#45a5f5" />
      <path d="M7.4 12.4l3.2 3.2 6-6.2" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="square" />
    </svg>
  );
}
