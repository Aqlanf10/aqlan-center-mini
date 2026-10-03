// Independent review boundary. Do not generate these pins during verification.
// Changes require independent patch AND verifier review; vendor metadata cannot authorize changes.
export const BRACES_EXCEPTION = Object.freeze({
  "officialVersions": ["0.1.0", "0.1.1", "0.1.2", "0.1.4", "0.1.5", "1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.5.1", "1.6.0", "1.7.0", "1.8.0", "1.8.1", "1.8.2", "1.8.3", "1.8.4", "1.8.5", "2.0.0", "2.0.1", "2.0.2", "2.0.3", "2.0.4", "2.1.0", "2.1.1", "2.2.0", "2.2.1", "2.2.2", "2.3.0", "2.3.1", "2.3.2", "3.0.0", "3.0.1", "3.0.2", "3.0.3"],
  "officialAdvisory": {
  "ghsa_id": "GHSA-vfj7-8cjw-p6xm",
  "cve_id": "CVE-2026-93687",
  "url": "https://api.github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  "html_url": "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  "summary": "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
  "description": "braces through 3.0.3 contains a stack overflow vulnerability in the recursive AST walkers that lack depth guards. Attackers can supply deeply nested brace patterns under the character limit to exhaust the call stack and terminate the Node.js process with an uncaught RangeError.",
  "type": "reviewed",
  "severity": "high",
  "source_code_location": "https://github.com/micromatch/braces",
  "identifiers": [
    {
      "value": "GHSA-vfj7-8cjw-p6xm",
      "type": "GHSA"
    },
    {
      "value": "CVE-2026-93687",
      "type": "CVE"
    }
  ],
  "references": [
    "https://nvd.nist.gov/vuln/detail/CVE-2026-93687",
    "https://github.com/micromatch/braces/issues/70",
    "https://github.com/micromatch/braces/blob/3.0.3/lib/compile.js#L49-L53",
    "https://github.com/micromatch/braces/blob/3.0.3/lib/expand.js#L102-L105",
    "https://github.com/micromatch/braces/blob/3.0.3/lib/parse.js#L38-L40",
    "https://www.vulncheck.com/advisories/braces-through-3.0.3-stack-overflow-via-deeply-nested-patterns",
    "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm"
  ],
  "published_at": "2026-09-18T18:31:41Z",
  "updated_at": "2026-10-02T22:36:34Z",
  "github_reviewed_at": "2026-10-02T22:36:33Z",
  "withdrawn_at": null,
  "vulnerabilities": [
    {
      "package": {
        "ecosystem": "npm",
        "name": "braces"
      },
      "vulnerable_version_range": "<= 3.0.3",
      "first_patched_version": null,
      "vulnerable_functions": []
    }
  ],
  "cvss": {
    "vector_string": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
    "score": 7.5
  },
  "cvss_severities": {
    "cvss_v3": {
      "vector_string": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
      "score": 7.5
    },
    "cvss_v4": {
      "vector_string": "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N",
      "score": 8.7
    }
  },
  "cwes": [
    {
      "cwe_id": "CWE-674",
      "name": "Uncontrolled Recursion"
    }
  ]
},
  "ghsa": "GHSA-vfj7-8cjw-p6xm",
  "cve": "CVE-2026-93687",
  "package": "braces",
  "version": "3.0.3",
  "auditRange": "<=3.0.3",
  "officialRange": "<= 3.0.3",
  "advisoryUpdatedAt": "2026-10-02T22:36:34Z",
  "officialIntegrity": "sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==",
  "officialTarball": "https://registry.npmjs.org/braces/-/braces-3.0.3.tgz",
  "candidateIntegrity": "sha512-uQLbBYfkQj1AoL3DF68eUksPdsHJGwk5gCqUP8LMqYVbEr2lVX5EqzYXdzZVH4boyAAGm7htaU9wjL+294XqDg==",
  "provenanceSha256": "29d7863e7ab15f0c875c16b3cbe30b1fb24429bffcfab5b4c14d91037ee8d230",
  "patchSha256": "81a991e4e012ad194c082fdaa954024f2addb2878ebbf33739075e38bc76de71",
  "officialArchiveSha256": "1cd18e862c8640b4568b1425a7df4ee030ff201d45b2da8f9f222d2987494ffc",
  "files": {
    "LICENSE": "35bdd8a44339719441900fb50fbefc5e2dca1ca662cbaed7a687de842c8b70f2",
    "README.md": "947b0fc3cc12eaaa070207126213fbdf9ab2bf8cd13dcc6e4007b36b79309866",
    "index.js": "332ea07c7b006361aad12aa994ca75dc1db8e8382b884909e2f38f10b85c88a4",
    "lib/compile.js": "e8eb34720565c7a28875c26a6df66e42896a4fd04c5e7f5f8ca530972ddbd225",
    "lib/constants.js": "c18ac5adb57308f1ce42a28552da3a31f5d83709743ebd9a636336813a744d4b",
    "lib/expand.js": "20522e492222b69a702575f4fe6ea790992d8a89b8dc80c971acff6168f499f5",
    "lib/nesting-guard.js": "bef911e730ed8e38211e82eefd8e436cb81a8199c6a58d1aeb8470b8cfd9698e",
    "lib/parse.js": "662164f2b4022acf1cf7f37a08428051864af357a4a407aac56f8f5aa8810f30",
    "lib/stringify.js": "adcacfc169786c09d65b69f76a7c463b6211b18954c53156bf5a9d6321447e97",
    "lib/utils.js": "b5a7596aa67730412b3c029ef09e84e6b67b8e445cffd35d1d295549c89066c7",
    "package.json": "56f08b888a4f30dc7cf8a7dbb36ffe92b737912ba36abe9d069d32167c957ac7"
  },
  "advisoryLeaf": {
    "source": 1240992,
    "name": "braces",
    "dependency": "braces",
    "title": "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
    "url": "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
    "severity": "high",
    "cwe": [
      "CWE-674"
    ],
    "cvss": {
      "score": 7.5,
      "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"
    },
    "range": "<=3.0.3"
  }
});
