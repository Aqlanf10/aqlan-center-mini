import { blankFacialContent, type FacialContent, type FacialLandmark } from "../../lib/ortho-facial-analysis";
export function syntheticFace(): FacialContent {
  const content = blankFacialContent({ sha256: "a".repeat(64), width: 1000, height: 1200, exifOrientation: 1 });
  content.occurrence.sourceNote = "Synthetic source without a known original date";
  const pixels: Partial<Record<FacialLandmark, [number, number]>> = { axisTop: [500,100], axisBottom: [500,1100], tr: [500,150], gl: [500,450], sn: [500,750], me: [500,1050], sto: [500,850],
    paImageLeft: [100,500], exImageLeft: [260,500], enImageLeft: [420,500], enImageRight: [580,500], exImageRight: [740,500], paImageRight: [900,500] };
  for (const [key, [x,y]] of Object.entries(pixels)) content.landmarks[key as FacialLandmark] = { state: "located", x: x/1000, y: y/1200 };
  return content;
}
