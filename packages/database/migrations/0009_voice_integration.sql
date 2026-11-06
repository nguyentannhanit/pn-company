-- P&N — Tích hợp Giọng nói (Vbee) cho văn phòng.
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_kind_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_kind_check CHECK (kind IN
  ('AI_PROVIDER','TELEGRAM','GITHUB','DATABASE','DEPLOYMENT',
   'APP_STORE_CONNECT','GOOGLE_PLAY','OBJECT_STORAGE','SMTP','WEBHOOK','VOICE'));
