const signupFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** "18 September 2026", in whatever order the reader's locale puts it. */
export function formatSignupDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return signupFormat.format(d);
}
