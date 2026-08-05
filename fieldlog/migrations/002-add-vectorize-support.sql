ALTER TABLE attachments ADD COLUMN vector_id TEXT DEFAULT '';
ALTER TABLE attachments ADD COLUMN embedding_status TEXT DEFAULT 'pending';
ALTER TABLE attachments ADD COLUMN embedding_error TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_attachments_embedding_status ON attachments(embedding_status);
CREATE INDEX IF NOT EXISTS idx_attachments_vector_id ON attachments(vector_id);
