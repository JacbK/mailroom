import { describe, expect, it } from 'vitest';
import { SwitchboardError } from '../../src/errors.js';
import { parseQualifiedId, qualifyId } from '../../src/gmail/ids.js';

describe('account-qualified Gmail IDs', () => {
  it('round trips valid IDs', () => {
    expect(parseQualifiedId(qualifyId('work', '18abc_DEF-1'))).toEqual({
      alias: 'work',
      gmailId: '18abc_DEF-1',
    });
  });

  it('rejects ambiguous raw Gmail IDs', () => {
    expect(() => parseQualifiedId('18abc')).toThrow(SwitchboardError);
    try {
      parseQualifiedId('18abc');
    } catch (error) {
      expect((error as SwitchboardError).code).toBe('AMBIGUOUS_ID');
    }
  });

  it.each(['Work:id', 'work:', 'work:id:extra', '../work:id'])('rejects malformed ID %s', (id) => {
    expect(() => parseQualifiedId(id)).toThrow();
  });
});
