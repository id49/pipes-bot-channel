export type SenderIds = { phone?: string; userId?: string; parentUserId?: string };

// Entries may be a string or a list of strings; each entry can hold several senders separated by "," or ";".
export function parseAllowFrom(raw: unknown): string[] {
  const entries = typeof raw === "string"
    ? [raw]
    : Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : [];
  return entries
    .flatMap((entry) => entry.split(/[,;]/))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const digitsOf = (value: string): string => value.replace(/\D/g, "");

// BSUIDs start with a two-letter country code and a dot (US.123..., US.ENT.123...).
const BSUID_PREFIX = /^[A-Za-z]{2}\./;

// An entry starting with a country code and a dot is a BSUID and matches by exact ID; anything else is a phone number matched by digits.
export function isTrustedSender(sender: SenderIds, allowFrom: readonly string[]): boolean {
  const senderDigits = sender.phone ? digitsOf(sender.phone) : "";
  return allowFrom.some((raw) => {
    const entry = raw.trim();
    if (BSUID_PREFIX.test(entry)) {
      return entry === sender.userId || entry === sender.parentUserId;
    }
    const entryDigits = digitsOf(entry);
    return entryDigits !== "" && entryDigits === senderDigits;
  });
}
