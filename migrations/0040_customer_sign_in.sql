CREATE TABLE IF NOT EXISTS customer_login_redemptions (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_login_redemptions_expiry
  ON customer_login_redemptions(expires_at);

CREATE INDEX IF NOT EXISTS idx_orders_normalized_email_created
  ON orders(lower(trim(email)), created_at DESC);
