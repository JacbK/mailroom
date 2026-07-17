const aliasPattern = /^[a-z][a-z0-9-]{0,31}$/;

export function parseAccountSpec(value) {
  const separator = value.indexOf('=');
  const alias = value.slice(0, separator).trim();
  const email = value.slice(separator + 1).trim().toLowerCase();
  if (separator < 1 || !aliasPattern.test(alias) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`Invalid account "${value}". Use --account alias=email with a lowercase alias such as work or personal.`);
  }
  return { alias, email };
}

export function requestedAccounts(argv) {
  const accounts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--account') {
      const next = argv[index + 1];
      if (!next) throw new Error('--account needs a value in the form alias=email.');
      accounts.push(parseAccountSpec(next));
      index += 1;
    } else if (value.startsWith('--account=')) {
      accounts.push(parseAccountSpec(value.slice('--account='.length)));
    }
  }
  const aliases = new Map();
  const emails = new Map();
  for (const account of accounts) {
    const aliasEmail = aliases.get(account.alias);
    const emailAlias = emails.get(account.email);
    if (aliasEmail && aliasEmail !== account.email) {
      throw new Error(`Alias "${account.alias}" was supplied for more than one email.`);
    }
    if (emailAlias && emailAlias !== account.alias) {
      throw new Error(`${account.email} was supplied with more than one alias.`);
    }
    aliases.set(account.alias, account.email);
    emails.set(account.email, account.alias);
  }
  return [...aliases].map(([alias, email]) => ({ alias, email }));
}

export function assertAccountRequestAvailable(account, configured) {
  const matchingAlias = configured.find((item) => item.alias === account.alias);
  const matchingEmail = configured.find((item) => item.email.toLowerCase() === account.email);
  if (matchingAlias && matchingAlias.email.toLowerCase() !== account.email) {
    throw new Error(`Alias "${account.alias}" already belongs to ${matchingAlias.email}. Remove it first or choose another alias.`);
  }
  if (matchingEmail && matchingEmail.alias !== account.alias) {
    throw new Error(`${account.email} is already connected as "${matchingEmail.alias}". Reuse that alias or remove it first.`);
  }
  return matchingAlias;
}
