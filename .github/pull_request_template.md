## What

<!-- 1–2 sentences. The user-visible change. -->

## Why

<!-- The motivation. Link any issue / ticket. -->

## Sync / offline impact

- [ ] No new mutations
- [ ] New mutation goes through the sync engine (UUID-keyed, idempotent server RPC)
- [ ] Offline policy decision recorded in `ONLINE_ONLY_OPERATIONS` / `OFFLINE_SAFE_OPERATIONS`

## Permissions impact

- [ ] No permission changes
- [ ] `permissions.ts` matrix updated AND server RLS updated to match

## Tests

- [ ] Unit tests added / updated
- [ ] Manually verified offline path
- [ ] Manually verified realtime sync between two devices

## Screenshots / video

<!-- For UI changes. Include a mobile-width screenshot. -->
