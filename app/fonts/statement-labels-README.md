# Fixed statement labels

`statement-labels.woff` is a 39,572-byte self-hosted subset of DejaVu Sans, renamed **Aqlan Statement Labels**, used only for the current statement's fixed collected and agreement-paid label spans. It preserves normal GSUB/GPOS shaping, including mark positioning. It does not replace the page font, amount font, invoice/receipt typography, user-entered details or historical-detail component.

Source: `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` from the saved Debian environment. Redistribution notice: statement-labels-LICENSE.txt. Subset recipe and source/output hashes are retained in docs/review/statement-pdf-arabic-labels/. No font download or runtime third-party request.

The existing Plex font does not preserve these PDF labels under the tested runtime. Disabling Naskh `mark` removes the extracted gap but misplaces visible shadda, so that workaround is deliberately rejected. This subset instead uses a font whose correct visible mark placement does not cause the same intra-word split in the tested Chromium/Poppler stack.
