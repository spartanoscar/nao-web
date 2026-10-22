// Punto de entrada. NAO Web es para pantallas grandes (escritorio, tablet, iPad): en un teléfono no se carga
// el mundo (ni Three.js, ni la física, ni las mallas); el teléfono se usa como control, entrando por el QR.
import './ui/styles.css';
import { isPhoneScreen, showPhoneOnly } from './ui/device';

if (isPhoneScreen()) showPhoneOnly();
else void import('./app');
