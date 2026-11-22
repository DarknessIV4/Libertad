import { IdentityStore, type StoredIdentity } from '../../../electron/identity-store.ts';

// The desktop app's IdentityStore (client certificates, kept in a JSON file with owner-only permissions), with one
// change: connecting before any identity exists makes one without asking the system for the user name, because
// os.userInfo() can throw on Android, where the app's user may have no passwd entry.
// The folder it is given is the data folder nodejs-mobile gives the app (see channel.ts), which Android keeps
// private to the app and backs up with it.
export class AndroidIdentityStore extends IdentityStore {
  override async get(id?: string | null): Promise<StoredIdentity> {
    if (!(await this.list()).identities.length) await this.create('Libertad user', '');
    return super.get(id);
  }
}
