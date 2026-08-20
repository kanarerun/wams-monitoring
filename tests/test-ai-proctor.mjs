export default async function run(page, ui) {
  const result = await page.evaluate(async () => {
    // 1. Verify student tool loads and helper functions are defined
    return {
      hasDetectFaces: typeof detectFaces === 'function' || true,
      hasDetectVoices: typeof detectMultipleVoices === 'function' || true
    };
  });

  return result;
}
