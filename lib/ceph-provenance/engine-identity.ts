/**
 * Identity of the calculation engine that produced the values sealed at completion: the legacy `lib/ceph.ts`.
 * The source checksum is pinned by test, so any change to the engine needs an explicit version change here.
 * This names the engine; it does not validate it clinically (see docs/ceph: several legacy definitions differ
 * from their sources, and those differences are recorded in every new witness).
 */
export const CEPH_ENGINE_ID = "aqlan-legacy-ceph" as const;
export const CEPH_ENGINE_VERSION = "2026-11-18.1" as const;
export const CEPH_ENGINE_SOURCE_SHA256 = "db9bd6d9abc49ef47ff7a49a47dae8b25c0c9ae0704adad1147b40d0cd692997" as const;
