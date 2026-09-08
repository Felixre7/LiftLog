-- Legacy importers and restored backups may write payloads without the current projection helper.
-- Invalidate in the same transaction so a later indexed query can never trust stale search rows.
CREATE TRIGGER session_search_payload_changed AFTER UPDATE OF payload ON session BEGIN
  UPDATE session SET searchVersion = NULL WHERE id = NEW.id;
  DELETE FROM recorded_exercise_index WHERE sessionId = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER session_search_deleted AFTER DELETE ON session BEGIN
  DELETE FROM recorded_exercise_index WHERE sessionId = OLD.id;
END;
