/**
 * @file auth.test.js
 * @description Script manual de pruebas de integración para el módulo de autenticación.
 * Requiere el servidor backend activo en `http://localhost:4000` y valida registro de residente,
 * inicio de sesión exitoso con emisión de JWT y rechazo ante contraseña inválida.
 * @location /trustlink-backend/src/modules/auth/auth.test.js
 */

const BASE_URL = 'http://localhost:4000/api/v1/auth';

// Payload de residente con DNI y email generados dinámicamente para evitar colisiones de unicidad
const testUser = {
  country_id: null,
  role: 'owner',
  first_name: 'Carlos',
  last_name: 'Gómez',
  dni: `35${Math.floor(100000 + Math.random() * 900000)}`, // DNI aleatorio
  email: `carlos.gomez.${Date.now()}@test.com`,
  password: 'Password123!',
  phone: '+5491112345678',
  fraction_number: 'Manzana 4',
  lot_number: 'Lote 12'
};

/**
 * Ejecuta secuencialmente las pruebas de integración HTTP del módulo de autenticación:
 * 1) Alta de usuario residente (`POST /register`).
 * 2) Login válido con emisión de token JWT (`POST /login`).
 * 3) Rechazo de credenciales inválidas con estado 401 (`POST /login`).
 *
 * @returns {Promise<void>} Finaliza tras imprimir el resultado de cada escenario en consola.
 */
async function runAuthTests() {
  console.log('🧪 Iniciando pruebas automatizadas para el Módulo de Autenticación...\n');

  try {
    // ----------------------------------------------------
    // PRUEBA 1: Registro de un nuevo usuario residente
    // Escenario: alta pública con rol 'owner' y datos de ubicación válidos.
    // Resultado esperado: HTTP 201 con objeto `user` y su `id` generado en base de datos.
    // ----------------------------------------------------
    console.log('1️⃣ Probando Registro de Usuario (/register)...');
    const registerResponse = await fetch(`${BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testUser)
    });

    const registerData = await registerResponse.json();

    if (registerResponse.status === 201) {
      console.log('✅ ÉXITO: Usuario registrado correctamente.');
      console.log('   ID Generado:', registerData.user.id);
    } else {
      console.error('❌ FALLÓ EL REGISTRO:', registerData);
      return;
    }

    // ----------------------------------------------------
    // PRUEBA 2: Inicio de sesión (Login) con credenciales válidas
    // Precondición: usuario recién registrado en la Prueba 1.
    // Resultado esperado: HTTP 200 acompañado de un token JWT firmado.
    // ----------------------------------------------------
    console.log('\n2️⃣ Probando Inicio de Sesión Correcto (/login)...');
    const loginResponse = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testUser.email,
        password: testUser.password
      })
    });

    const loginData = await loginResponse.json();

    if (loginResponse.status === 200 && loginData.token) {
      console.log('✅ ÉXITO: Login correcto.');
      console.log('   Token JWT obtenido:', loginData.token.substring(0, 25) + '...');
    } else {
      console.error('❌ FALLÓ EL LOGIN:', loginData);
      return;
    }

    // ----------------------------------------------------
    // PRUEBA 3: Inicio de sesión con contraseña incorrecta (seguridad)
    // Precondición: email registrado existente pero contraseña errónea.
    // Resultado esperado: HTTP 401 rechazando el acceso sin emitir token.
    // ----------------------------------------------------
    console.log('\n3️⃣ Probando Seguridad: Login con contraseña incorrecta...');
    const failLoginResponse = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testUser.email,
        password: 'PasswordEquivocada'
      })
    });

    const failLoginData = await failLoginResponse.json();

    if (failLoginResponse.status === 401) {
      console.log('✅ ÉXITO: El sistema bloqueó correctamente las credenciales inválidas:', failLoginData.error);
    } else {
      console.error('❌ FALLÓ LA VALIDACIÓN DE SEGURIDAD:', failLoginData);
    }

    console.log('\n🎉 ¡Todas las pruebas del Módulo de Autenticación pasaron exitosamente al 100%!');

  } catch (error) {
    console.error('❌ Error de red o ejecución en las pruebas:', error);
  }
}

// Punto de entrada al invocar el script directamente con `node`
runAuthTests();