// Cámaras del NAO V6 (doc family_nao_technical_video_naov6): dos OV5640 idénticas. Posición y orientación
// salen de los frames ópticos del URDF (CameraTop_optical_frame, CameraBottom_optical_frame).

export const NAO_CAMERAS = [
  { index: 0, name: 'CameraTop', id: 'kTopCamera', frame: 'CameraTop_optical_frame' },
  { index: 1, name: 'CameraBottom', id: 'kBottomCamera', frame: 'CameraBottom_optical_frame' },
] as const;

/** Campo de visión: 67.4° DFOV (56.3° HFOV, 43.7° VFOV), en radianes */
export const CAMERA_HFOV = (56.3 * Math.PI) / 180;
export const CAMERA_VFOV = (43.7 * Math.PI) / 180;

/** Modelo de cámara (AL::kOV5640) */
export const CAMERA_MODEL_OV5640 = 3;
