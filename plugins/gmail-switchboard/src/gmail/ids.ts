import { SwitchboardError } from '../errors.js';

const aliasPattern = /^[a-z][a-z0-9-]{0,31}$/;
const gmailIdPattern = /^[A-Za-z0-9_-]+$/;

export function qualifyId(alias: string, gmailId: string): string {
  if (!aliasPattern.test(alias) || !gmailIdPattern.test(gmailId)) {
    throw new SwitchboardError(
      'INVALID_INPUT',
      'Cannot qualify an invalid Gmail identifier.',
      'Use the account-qualified ID returned by Gmail Switchboard.',
    );
  }
  return `${alias}:${gmailId}`;
}

export function parseQualifiedId(value: string): { alias: string; gmailId: string } {
  const separator = value.indexOf(':');
  if (separator < 1) {
    throw new SwitchboardError(
      'AMBIGUOUS_ID',
      `"${value}" is not account-qualified.`,
      'Use an ID such as `primary:<id>` from a search result.',
    );
  }
  const alias = value.slice(0, separator);
  const gmailId = value.slice(separator + 1);
  if (!aliasPattern.test(alias) || !gmailIdPattern.test(gmailId)) {
    throw new SwitchboardError(
      'INVALID_INPUT',
      `"${value}" is not a valid account-qualified Gmail ID.`,
      'Reuse the exact ID returned by Gmail Switchboard.',
    );
  }
  return { alias, gmailId };
}
