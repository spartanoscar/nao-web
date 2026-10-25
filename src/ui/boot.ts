// Pantalla de entrada (estilo juego): login de usuarios registrados, aceptación obligatoria de la licencia del
// modelo oficial y barra "Cargando universo…". Mientras la persona escribe, el mundo ya se carga detrás (mallas,
// física, primer cuadro). Nunca se entra sin el modelo oficial (si falla, se puede reintentar) ni sin la física.

import { ApiError, type User, login, loginDemo, me } from '../net/api';
import { MESHES_LICENSE_URL, acceptLicense, licenseAccepted } from './meshLicense';

export interface BootHooks {
  /** Descarga y monta las mallas oficiales (solo con la licencia aceptada) */
  loadModel(onProgress: (loaded: number, total: number) => void): Promise<void>;
  /** Física MuJoCo lista (necesita las mallas); si falla no se entra */
  physics: Promise<void>;
  /** Dibuja el mundo una vez (compila shaders y sombras) antes de mostrarlo */
  warmUp(): void;
}

/** Pesos de cada parte en la barra de progreso */
const WEIGHT = { physics: 0.3, model: 0.6, world: 0.1 };

const LICENSE_REQUIRED = 'Para entrar tienes que aceptar la licencia del modelo oficial del NAO.';

export function runBoot(hooks: BootHooks): Promise<User> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = 'boot';
    root.innerHTML = `
      <div class="boot-card" role="dialog" aria-label="Entrar a NAO Web">
        <header class="boot-brand">
          <img src="/brand/logo-libertadores.png" alt="Fundación Universitaria Los Libertadores" />
          <div><h1>NAO Web</h1><p>Gemelo digital del robot NAO V6</p></div>
        </header>
        <p class="boot-welcome" hidden></p>
        <form class="boot-form" novalidate hidden>
          <label class="boot-field boot-cred">Usuario
            <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required />
          </label>
          <label class="boot-field boot-cred">Contraseña
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
          <label class="boot-license">
            <input name="license" type="checkbox" />
            <span>Acepto la <a href="${MESHES_LICENSE_URL}" target="_blank" rel="noopener">licencia</a> del modelo 3D
              oficial del NAO (Aldebaran / SoftBank Robotics · CC BY-NC-ND 4.0: uso no comercial y sin modificaciones).
              Sin aceptarla no se puede entrar.</span>
          </label>
          <p class="boot-error" role="alert"></p>
          <button type="submit" class="boot-play">Entrar</button>
          <button type="button" class="boot-demo boot-cred" title="Sin cuenta: el mundo completo y un poco de IA al día">Probar demo</button>
        </form>
        <div class="boot-loading">
          <div class="boot-bar"><span></span></div>
          <p class="boot-status">Cargando universo… 0%</p>
          <p class="boot-detail"></p>
        </div>
      </div>
      <footer class="boot-footer">Proyecto de grado · Fundación Universitaria Los Libertadores · uso académico y gratuito</footer>`;
    document.body.append(root);

    const form = root.querySelector<HTMLFormElement>('.boot-form')!;
    const username = form.elements.namedItem('username') as HTMLInputElement;
    const password = form.elements.namedItem('password') as HTMLInputElement;
    const license = form.elements.namedItem('license') as HTMLInputElement;
    const error = root.querySelector<HTMLElement>('.boot-error')!;
    const play = root.querySelector<HTMLButtonElement>('.boot-play')!;
    const demo = root.querySelector<HTMLButtonElement>('.boot-demo')!;
    const welcome = root.querySelector<HTMLElement>('.boot-welcome')!;
    const bar = root.querySelector<HTMLElement>('.boot-bar span')!;
    const status = root.querySelector<HTMLElement>('.boot-status')!;
    const detail = root.querySelector<HTMLElement>('.boot-detail')!;

    let user: User | null = null;
    let physics: 'loading' | 'ready' | 'failed' = 'loading';
    let model: 'waiting' | 'loading' | 'done' | 'failed' = 'waiting';
    let modelProgress = 0;
    let entering = false;
    /** Aún no se sabe si hay sesión (cookie): el formulario no se muestra para que no parpadee */
    let checking = true;

    const render = () => {
      const p =
        (physics === 'ready' ? WEIGHT.physics : 0) +
        (model === 'done' ? WEIGHT.model : WEIGHT.model * modelProgress) +
        (entering ? WEIGHT.world : 0);
      bar.style.width = `${Math.round(p * 100)}%`;
      const loaded = physics === 'ready' && model === 'done';
      status.textContent = entering
        ? '¡Universo listo!'
        : loaded && !user
          ? 'Universo cargado · inicia sesión para entrar'
          : `Cargando universo… ${Math.round(p * 100)}%`;
      const parts = [
        physics === 'ready' ? 'Física MuJoCo ✓' : physics === 'failed' ? 'Física MuJoCo: no arrancó' : 'Física MuJoCo…',
        model === 'waiting'
          ? 'Modelo del NAO: acepta la licencia'
          : model === 'done'
            ? 'Modelo del NAO ✓'
            : model === 'failed'
              ? 'Modelo del NAO: falló la descarga'
              : `Modelo del NAO ${Math.round(modelProgress * 100)}%`,
      ];
      detail.textContent = parts.join(' · ');
      if (user) {
        // Con sesión: solo el saludo y la carga. Si falta aceptar la licencia queda únicamente la casilla (al
        // marcarla se entra solo); el botón vuelve solo para reintentar una descarga fallida.
        welcome.hidden = false;
        welcome.textContent = `¡Hola, ${user.displayName}! Preparando tu universo…`;
        root.querySelectorAll<HTMLElement>('.boot-cred').forEach((el) => (el.hidden = true));
        form.hidden = licenseAccepted() && model !== 'failed';
        play.hidden = model !== 'failed';
        play.textContent = 'Reintentar';
      } else form.hidden = checking;
      tryEnter();
    };

    const startModel = () => {
      if (model === 'loading' || model === 'done') return;
      model = 'loading';
      modelProgress = 0;
      render();
      hooks
        .loadModel((n, total) => {
          modelProgress = total ? n / total : 0;
          render();
        })
        .then(() => {
          model = 'done';
          render();
        })
        .catch((e) => {
          console.warn('Modelo oficial no disponible:', e);
          model = 'failed';
          error.textContent = 'No se pudo descargar el modelo del NAO. Revisa la conexión y reintenta.';
          render();
        });
    };

    const tryEnter = () => {
      if (entering || !user || model !== 'done' || physics !== 'ready') return;
      entering = true;
      render();
      hooks.warmUp();
      // Dos cuadros para que el primer render (shaders, sombras) termine antes de mostrar el mundo
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          root.classList.add('boot-out');
          setTimeout(() => {
            root.remove();
            resolve(user!);
          }, 700);
        }),
      );
    };

    license.checked = licenseAccepted();
    license.addEventListener('change', () => {
      if (!license.checked) return;
      acceptLicense();
      error.textContent = '';
      startModel(); // la descarga empieza ya, mientras se escribe la contraseña
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (!license.checked) {
        error.textContent = LICENSE_REQUIRED;
        return;
      }
      if (model === 'failed') {
        error.textContent = '';
        startModel();
        return;
      }
      if (user) return render();
      if (!username.value.trim() || !password.value) {
        error.textContent = 'Escribe tu usuario y tu contraseña.';
        return;
      }
      play.disabled = true;
      try {
        user = await login(username.value.trim(), password.value);
        password.value = '';
      } catch (err) {
        error.textContent = err instanceof ApiError ? err.message : 'No hay conexión con el servidor.';
      } finally {
        play.disabled = false;
      }
      render();
    });

    // Sin cuenta: la cuenta demo compartida (server/auth.go handleDemo)
    demo.addEventListener('click', async () => {
      error.textContent = '';
      if (!license.checked) {
        error.textContent = LICENSE_REQUIRED;
        return;
      }
      demo.disabled = play.disabled = true;
      try {
        user = await loginDemo();
      } catch (err) {
        error.textContent = err instanceof ApiError ? err.message : 'No hay conexión con el servidor.';
      } finally {
        demo.disabled = play.disabled = false;
      }
      render();
    });

    hooks.physics.then(
      () => {
        physics = 'ready';
        render();
      },
      (e) => {
        console.error('Física no disponible:', e);
        physics = 'failed';
        error.textContent = 'No se pudo arrancar la física del NAO. Recarga la página.';
        render();
      },
    );
    if (licenseAccepted()) startModel();
    // ¿Ya había sesión? (cookie de 30 días)
    me()
      .then((u) => {
        user = u;
        checking = false;
        render();
        if (!u) username.focus();
      })
      .catch(() => {
        checking = false;
        render();
        error.textContent = 'No hay conexión con el servidor. Recarga la página en un momento.';
      });
    render();
  });
}
