CREATE TABLE callback_requests (
  request_id Utf8 NOT NULL,
  request_type Utf8,
  status Utf8,
  phone Utf8,
  name Utf8,
  comment Utf8,
  page_url Utf8,
  product_name Utf8,
  product_price Utf8,
  message_id Utf8,
  created_at Utf8,
  accepted_by Utf8,
  accepted_at Utf8,
  PRIMARY KEY (request_id)
);
