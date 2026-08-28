/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * بناء مستقل: يُخرج `server.js` ومعه أدنى ما يلزم من الاعتماديات فقط.
   *
   * بلا هذا تحتاج صورة النشر `node_modules` كاملة — مئات الميغابايتات وآلاف الملفات
   * التي لا يقرأها التشغيل أصلًا، فيبطؤ كل نشر وتتّسع مساحة الهجوم بلا مقابل.
   */
  output: "standalone",
};
export default nextConfig;
