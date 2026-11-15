// Phone photos are large. Both readers do better and faster with a sharp, upright image of about 1600 px.

export type Photo = { base64: string; mimeType: "image/jpeg"; url: string; width: number; height: number };

export async function preparePhoto(file: Blob, maxSide = 1600): Promise<Photo> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * scale);
  const height = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const url = canvas.toDataURL("image/jpeg", 0.9);
  return { base64: url.slice(url.indexOf(",") + 1), mimeType: "image/jpeg", url, width, height };
}
