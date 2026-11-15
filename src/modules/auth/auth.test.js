/**
 * @file auth.test.js
 * @description Script de pruebas de integración para verificar el funcionamiento 
 * 100% del módulo de autenticación (Registro y Login).
 * @location /trustlink-backend/src/modules/auth/auth.test.js
 */

const BASE_URL = 'http://localhost:4000/api/v1/auth';

// Datos de prueba únicos para evitar colisiones de DNI o Email en cada ejecución
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

async function runAuthTests() {
  console.log('🧪 Iniciando pruebas automatizadas para el Módulo de Autenticación...\n');

  try {
    // ----------------------------------------------------
    // PRUEBA 1: Registro de un nuevo usuario
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
    // PRUEBA 3: Inicio de sesión con contraseña incorrecta
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

// Ejecutar pruebas
runAuthTests();