import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteTrustRepository} from '../data/repositories/SqliteTrustRepository';
import {DeviceMeshRuntime} from '../runtime/identity/DeviceMeshRuntime';
import {NodeDatabase} from './helpers/NodeDatabase';

const trust = {
  deviceId: 'peer-1',
  deviceName: 'Desktop',
  publicKey: 'B' + 'A'.repeat(86) + '=',
  endpoint: 'https://desktop.example',
  localDeviceId: 'mobile-1',
  localPublicKey: 'B' + 'A'.repeat(86) + '=',
  createdAt: '2026-09-30T00:00:00.000Z',
};

describe('Device Mesh health', () => {
  test('reports trust separately from reachability and does not mutate trust', async () => {
    const db = new NodeDatabase();
    await migrateDatabase(db, appMigrations);
    const repository = new SqliteTrustRepository(db);
    await repository.save(trust);
    const runtime = new DeviceMeshRuntime(repository);

    const before = await repository.get('peer-1');
    const health = await runtime.getHealth('peer-1');
    const after = await repository.get('peer-1');

    expect(health).toMatchObject({
      deviceId: 'peer-1',
      paired: true,
      trusted: true,
      reachable: false,
      transport: 'unknown',
      peerRole: 'desktop-node',
    });
    expect(after).toEqual(before);
    await db.close();
  });

  test('a stale device remains untrusted even when it has a recent last-seen value', async () => {
    const db = new NodeDatabase();
    await migrateDatabase(db, appMigrations);
    const repository = new SqliteTrustRepository(db);
    await repository.save({...trust, trustState: 'stale', lastSeenAt: '2026-09-30T00:01:00.000Z'});
    const runtime = new DeviceMeshRuntime(repository);

    await expect(runtime.getHealth('peer-1')).resolves.toMatchObject({
      trusted: false,
      reachable: false,
      lastSeen: '2026-09-30T00:01:00.000Z',
    });
    await db.close();
  });

  test('bounds a reachability probe and converts a hung peer into a diagnostic error', async () => {
    const db = new NodeDatabase();
    await migrateDatabase(db, appMigrations);
    const repository = new SqliteTrustRepository(db);
    await repository.save(trust);
    const runtime = new DeviceMeshRuntime(
      repository,
      {
        check: () => new Promise<boolean>(() => undefined),
      },
      {timeoutMs: 10},
    );

    await expect(runtime.getHealth('peer-1')).resolves.toMatchObject({
      reachable: false,
      lastErrorCode: 'timeout',
    });
    await db.close();
  });
});
