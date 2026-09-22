/** Retry transport failures only. Cache rejection and playback errors are NOT network failures. */
export function normalizeRetryPolicy(config={},unit='ms'){
  const maxRetries=config.maxRetries??0;
  const delay=unit==='ms'?(config.delayMs??250):(config.delayS??0.25);
  if(!Number.isSafeInteger(maxRetries)||maxRetries<0||maxRetries>100 || !Number.isFinite(delay)||delay<0){
    throw new TypeError('Invalid retry maxRetries or delay');
  }
  return {maxRetries,delay};
}
export function isRetryableHttpError(error){
  const message=String(error?.message??error);
  const match=/\bHTTP\s+(\d{3})\b/.exec(message);
  if(match)return [408,429].includes(Number(match[1]))||Number(match[1])>=500;
  return !(/AbortError|aborted|INVALID|parse|manifest profile|representation/i.test(message));
}
