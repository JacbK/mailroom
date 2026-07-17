export interface AccountConfig {
  alias: string;
  email: string;
}

export interface AccountCredential {
  email: string;
  refreshToken: string;
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MessageView {
  account_alias: string;
  account_email: string;
  message_id: string;
  thread_id: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: string | null;
  snippet: string;
  labels: string[];
  body_text: string;
  body_truncated: boolean;
  attachments: AttachmentInfo[];
  gmail_url: string;
}

export interface SearchResult {
  account_alias: string;
  account_email: string;
  message_id: string;
  thread_id: string;
  subject: string;
  from: string;
  to: string[];
  date: string | null;
  snippet: string;
  labels: string[];
  gmail_url: string;
}

export interface SearchPage {
  results: SearchResult[];
  next_cursor: string | null;
  result_count: number;
  searched_accounts: AccountConfig[];
}
