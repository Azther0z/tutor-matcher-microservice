// Run after the replica set elects a primary. Credentials arrive through process
// environment, never command output. Re-running does not rotate existing users.
const admin = db.getSiblingDB('admin');
admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);
try { rs.status(); } catch { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] }); }
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  if (admin.hello().isWritablePrimary) { ready = true; break; }
  sleep(1000);
}
if (!ready) throw new Error('Replica set did not elect a primary');
for (const owner of ['tutor', 'review', 'messaging', 'notification']) {
  const owned = db.getSiblingDB(`${owner}_db`);
  const user = `${owner}_owner`;
  const password = process.env[`${owner.toUpperCase()}_DB_PASSWORD`];
  if (!password) throw new Error('Missing owner database credential');
  if (!owned.getUser(user)) owned.createUser({ user, pwd: password, roles: [{ role: 'readWrite', db: `${owner}_db` }] });
}
