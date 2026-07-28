-- 0037_purge_orphaned_platform_users.sql — hardDeleteBusiness previously left
-- the deleted business's owner (and any other member) behind in
-- platform_users when they held no membership elsewhere, so their email
-- stayed "already registered" forever, blocking a fresh signup with it (see
-- EmailPasswordMismatchError in business-provisioning.ts). platform-service.ts
-- now purges these as part of the delete; this sweeps out any that already
-- went orphaned this way before that fix.
DELETE FROM platform_users
 WHERE NOT EXISTS (
   SELECT 1 FROM users WHERE users.platform_user_id = platform_users.id
 );
