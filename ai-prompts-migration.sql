-- AI Prompts Migration

CREATE TABLE IF NOT EXISTS user_prompts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_type VARCHAR(50) NOT NULL,
  template_data TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, template_type)
);

CREATE INDEX idx_user_prompts_user ON user_prompts(user_id);

-- Verify
SELECT 'user_prompts table' as migration, 
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_prompts') 
            THEN '✅ Created' 
            ELSE '❌ Failed' 
       END as status;
