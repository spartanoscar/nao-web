// Detección de teléfono: pantalla táctil cuyo lado corto mide menos de 600 px (los iPad y tablets miden 744 px
// o más). Así también se detecta un teléfono girado en horizontal.

const PHONE_SHORT_SIDE = 600;

export function isPhoneScreen(): boolean {
  const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  return touch && Math.min(screen.width, screen.height) < PHONE_SHORT_SIDE;
}

export function showPhoneOnly(): void {
  // Sin mundo: fuera también el panel y sus controles
  for (const id of ['app', 'hud', 'panel', 'panel-toggle', 'keys']) document.getElementById(id)?.remove();
  const card = document.createElement('main');
  card.className = 'phone-only';
  card.innerHTML = `
    <div class="phone-only-card">
      <img src="/brand/logo-libertadores.png" alt="" class="phone-only-logo" />
      <h1>NAO Web</h1>
      <p class="phone-only-lead">El mundo del NAO necesita una pantalla grande.</p>
      <p>Ábrelo en un <strong>computador</strong>, una <strong>tablet</strong> o un <strong>iPad</strong>.</p>
      <p class="phone-only-hint">¿Quieres usar este teléfono como control? Entra desde el computador y escanea el
        código QR del botón <strong>Conectar móvil</strong>.</p>
    </div>`;
  document.body.append(card);
}
