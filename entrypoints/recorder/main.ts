let recorder: MediaRecorder | undefined;
let captureStream: MediaStream | undefined;
let chunks: Blob[] = [];
let startedAt = 0;
let timerId = 0;

function element<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Elemento ausente: ${selector}`);
  return value;
}

function safeName(value: string): string {
  return value.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'gravacao-stream';
}

function formatTime(milliseconds: number): string {
  const total = Math.floor(milliseconds / 1000);
  const hours = String(Math.floor(total / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function updateTimer(): void {
  element<HTMLTimeElement>('#timer').textContent = formatTime(Date.now() - startedAt);
}

function preferredMimeType(): string | undefined {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
}

async function startRecording(): Promise<void> {
  const status = element('#status');
  status.textContent = 'Solicitando permissão…';
  try {
    const options = {
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    } as DisplayMediaStreamOptions;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('getDisplayMedia não suportado neste navegador');
    }
    captureStream = await navigator.mediaDevices.getDisplayMedia(options);
    chunks = [];
    const mimeType = preferredMimeType();
    recorder = new MediaRecorder(captureStream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener('stop', saveRecording, { once: true });
    captureStream.getVideoTracks()[0]?.addEventListener('ended', () => stopRecording(), { once: true });
    element<HTMLVideoElement>('#preview').srcObject = captureStream;
    element('#placeholder').setAttribute('hidden', '');
    element('#led').classList.add('active');
    element<HTMLButtonElement>('#start').disabled = true;
    element<HTMLButtonElement>('#stop').disabled = false;
    status.textContent = 'Gravando';
    startedAt = Date.now(); updateTimer(); timerId = window.setInterval(updateTimer, 500);
    recorder.start(1000);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error ?? 'Captura cancelada');
    // Friendly mapping pt-BR
    const lower = msg.toLowerCase();
    if (lower.includes('notallowed') || lower.includes('permission')) status.textContent = 'Permissão negada — permita compartilhar a aba';
    else if (lower.includes('notfound') || lower.includes('no display')) status.textContent = 'Nenhuma aba disponível para gravar';
    else if (lower.includes('abort')) status.textContent = 'Captura cancelada';
    else status.textContent = msg.slice(0, 160);
    console.warn('[Stream2JD] startRecording failed', error);
  }
}

function stopRecording(): void {
  if (recorder?.state === 'recording') recorder.stop();
  captureStream?.getTracks().forEach((track) => track.stop());
  window.clearInterval(timerId);
  element('#led').classList.remove('active');
  element<HTMLButtonElement>('#stop').disabled = true;
  element('#status').textContent = 'Finalizando arquivo';
}

function saveRecording(): void {
  if (!chunks.length) {
    element('#status').textContent = 'Nenhum dado gravado';
    return;
  }
  const blob = new Blob(chunks, { type: recorder?.mimeType || 'video/webm' });
  if (!blob.size) {
    element('#status').textContent = 'Gravação vazia — tente novamente';
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeName(element<HTMLInputElement>('#filename').value)}.webm`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  element('#status').textContent = `Salvo · ${(blob.size / 1024 / 1024).toFixed(1)} MB`;
  element<HTMLButtonElement>('#start').disabled = false;
  const preview = element<HTMLVideoElement>('#preview');
  preview.pause();
  preview.srcObject = null;
  element('#placeholder').removeAttribute('hidden');
  chunks = [];
}

const params = new URL(location.href).searchParams;
const initialTitle = params.get('title');
if (initialTitle) element<HTMLInputElement>('#filename').value = safeName(initialTitle);
const drmHint = params.get('drm');
if (drmHint) {
  try {
    const status = element('#status');
    const map: Record<string, string> = {
      widevine: 'Widevine detectado: a gravacao registra a reproducao autorizada; imagem pode sair preta por protecao.',
      playready: 'PlayReady detectado: a gravacao registra a reproducao autorizada; imagem pode sair preta por protecao.',
      fairplay: 'FairPlay detectado: a gravacao registra a reproducao autorizada; imagem pode sair preta por protecao.',
    };
    status.textContent = map[drmHint.toLowerCase()] ?? 'Conteudo protegido: a gravacao registra a reproducao autorizada.';
  } catch {
    // Mantem o texto padrao de espera.
  }
}
element<HTMLButtonElement>('#start').addEventListener('click', () => void startRecording());
element<HTMLButtonElement>('#stop').addEventListener('click', stopRecording);
