export type EndpointInfo = {
  id: string;
  name: string;
  slug: string;
  forwardUrl: string | null;
  forwardEnabled: boolean;
  hasSecret: boolean;
};

export type RequestSummary = {
  id: string;
  method: string;
  received_at: string;
  size_bytes: number;
  signature_status: string;
  content_type: string | null;
};

export type RequestDetail = RequestSummary & {
  path: string;
  query: unknown;
  headers: unknown;
  body: string | null;
  body_encoding: string;
  ip: unknown;
};

export type Delivery = {
  id: string;
  attempt: number;
  status_code: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
};
