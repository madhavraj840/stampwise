-- hourly cleanup deletes expired sessions; approving a password reset deletes all of a shop's sessions
CREATE INDEX IF NOT EXISTS sessions_exp ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_subject ON sessions(role, subject_id);
