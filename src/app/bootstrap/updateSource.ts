import {unconfiguredUpdateService, type UpdateService} from '../../domain/update/UpdateService';
import type {HttpTransport} from '../../providers/network/HttpTransport';
import {GitHubReleaseUpdateService} from '../../providers/update/GitHubReleaseUpdateService';

// Development stays in the private mobile repository; anonymous APKs read
// releases from this public repository. Change only this value if it moves.
export const publicUpdateRepository: string | undefined = 'chx6418-source/CetaMesh';

export function createUpdateService(
  transport: HttpTransport,
  currentVersion: string,
  repository: string | undefined = publicUpdateRepository,
): UpdateService {
  return repository
    ? new GitHubReleaseUpdateService(transport, currentVersion, repository)
    : unconfiguredUpdateService;
}
