# Text presentation dependency review — 2026-11-03

The draft adds MIT-licensed `pptxgenjs@4.0.1` for native editable text slides and `jszip@3.10.1` as a direct development dependency for inspecting the generated Office package in integration tests.

The unmodified PptxGenJS dependency graph selects `image-size@1.2.1`, and the unchanged audit gate correctly rejected two high findings. No advisory was suppressed. The proposal pins only `pptxgenjs@4.0.1 > image-size` to official npm `2.0.4` and adds this exact consumer/version pair to the fail-closed override registry. Arbitrary consumers, ranges, aliases and the vulnerable version remain rejected; existing braces exception and fixture are unchanged.

Source: [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq), updated 2026-09-24, identifies image-size 2.0.3 as the first patched release for the JXL/HEIF infinite loop. Registry metadata for 2.0.4 points to the upstream image-size project at Codeberg, with integrity `sha512-QRUkFFsRV/6fuESxb9Vkq+a0LkSrgKXuc2NEqfikiXxxN/G3tjWt5EVUlMaImRBZRZK/jRBEbYvpPYZL8t08Zw==`; package-lock.json pins that exact artifact. The application uses only addText/addNotes and no images or filesystem loaders. Inspection of PptxGenJS 4.0.1 distribution found no live image-size import (the old getSizeFromImage helper is commented out). This narrowly establishes compatibility for the text renderer; adding images later requires a new compatibility review.

Validation and remaining review requirements are recorded in [validation](2026-11-03-validation.md). This draft still needs independent review before adoption; it does not authorize production deployment.
