// mega_robot_2axes.ino
// Arduino MEGA - Robot 6 Axes + Joysticks + Commandes série
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver();

// --- LIMITES ET POSITIONS INITIALES (valeurs PWM) ---
float posBase = 430.0;      const int B_MIN = 200; const int B_MAX = 660;
float posEpaule = 650.0;    const int E_MIN = 500; const int E_MAX = 800;
float posCoude = 500.0;     const int C_MIN = 400; const int C_MAX = 630;
float posPoignet = 100.0;   const int P_MIN = 100; const int P_MAX = 500;
float posInc = 250.0;       const int I_MIN = 200; const int I_MAX = 550;
float posPince = 270.0;     const int G_MIN = 150; const int G_MAX = 270;

// --- PINS JOYSTICKS ---
const int J2_X = A0; const int J2_Y = A1;  // Joystick 2 : Base + Epaule
const int J1_X = A2; const int J1_Y = A3;  // Joystick 1 : Coude + Poignet
const int J1_SW = 2;                         // Inclinaison +
const int J2_SW = 6;                         // Inclinaison -
const int J3_OPEN = 5;                       // Pince ouvrir
const int J3_CLOSE = 3;                      // Pince fermer
const int LED_PIN = 13;                      // Témoin

const float SENSIBILITE = 0.6;
const int ZONE_STABLE = 85;

// --- Envoi joystick au backend ---
unsigned long lastJoySend = 0;
const unsigned long JOY_INTERVAL = 200;  // ms entre les envois

void setup() {
  Serial.begin(115200);
  Wire.begin();
  pwm.begin();
  pwm.setPWMFreq(60);

  pinMode(LED_PIN, OUTPUT);
  pinMode(J1_SW, INPUT_PULLUP);
  pinMode(J2_SW, INPUT_PULLUP);
  pinMode(J3_OPEN, INPUT_PULLUP);
  pinMode(J3_CLOSE, INPUT_PULLUP);

  actualiserServos();
  Serial.println("SYSTEM_READY");
}

void loop() {
  bool aBouge = false;

  // 1. LECTURE DES COMMANDES SÉRIE (WEB/REMOTE)
  if (Serial.available() > 0) {
    char cmd = Serial.read();

    // Arrêt d'urgence
    if (cmd == 'A') {
      for (int i = 0; i < 3; i++) {
        digitalWrite(LED_PIN, HIGH); delay(100);
        digitalWrite(LED_PIN, LOW); delay(100);
      }
      posBase = 430; posEpaule = 600; posCoude = 500;
      posPoignet = 100; posInc = 400; posPince = 270;
      actualiserServos();
      Serial.println("EMERGENCY_ACK");
    }
    // Synchronisation
    else if (cmd == 'S') {
      digitalWrite(LED_PIN, HIGH);
      posBase = 430; posEpaule = 600; posCoude = 500;
      posPoignet = 100; posInc = 400; posPince = 270;
      actualiserServos();
      delay(800);
      digitalWrite(LED_PIN, LOW);
      Serial.println("SYNC_OK");
    }
    // Commandes position : B=val, E=val, C=val, P=val, I=val, G=val
    else {
      int val = Serial.parseInt();
      if (cmd == 'B') { posBase = val; aBouge = true; }
      else if (cmd == 'E') { posEpaule = val; aBouge = true; }
      else if (cmd == 'C') { posCoude = val; aBouge = true; }
      else if (cmd == 'P') { posPoignet = val; aBouge = true; }
      else if (cmd == 'I') { posInc = val; aBouge = true; }
      else if (cmd == 'G') { posPince = val; aBouge = true; }
    }
  }

  // 2. LECTURE DES JOYSTICKS ANALOGIQUES
  int x2 = analogRead(J2_X) - 512;
  int y2 = analogRead(J2_Y) - 512;
  int x1 = analogRead(J1_X) - 512;
  int y1 = analogRead(J1_Y) - 512;

  if (abs(x2) > ZONE_STABLE) { posBase += (x2 / 512.0) * SENSIBILITE; aBouge = true; }
  if (abs(y2) > ZONE_STABLE) { posEpaule += (y2 / 512.0) * SENSIBILITE; aBouge = true; }
  if (abs(x1) > ZONE_STABLE) { posCoude += (x1 / 512.0) * SENSIBILITE; aBouge = true; }
  if (abs(y1) > ZONE_STABLE) { posPoignet += (y1 / 512.0) * SENSIBILITE; aBouge = true; }

  // 3. COMMANDES DIGITALES (BOUTONS)
  if (digitalRead(J1_SW) == LOW) { posInc += 3.0; aBouge = true; }
  if (digitalRead(J2_SW) == LOW) { posInc -= 3.0; aBouge = true; }
  if (digitalRead(J3_OPEN) == LOW) { posPince += 3.0; aBouge = true; }
  if (digitalRead(J3_CLOSE) == LOW) { posPince -= 3.0; aBouge = true; }

  // 4. ACTUALISATION SI MOUVEMENT
  if (aBouge) {
    contraindrePositions();
    actualiserServos();
  }

  // 5. ENVOI DONNÉES JOYSTICK AU BACKEND
  unsigned long now = millis();
  if (now - lastJoySend >= JOY_INTERVAL) {
    Serial.print("JX:");
    Serial.print(analogRead(J2_X));
    Serial.print(",JY:");
    Serial.print(analogRead(J2_Y));
    Serial.print(",J1X:");
    Serial.print(analogRead(J1_X));
    Serial.print(",J1Y:");
    Serial.println(analogRead(J1_Y));
    lastJoySend = now;
  }

  delay(15);
}

void contraindrePositions() {
  posBase = constrain(posBase, B_MIN, B_MAX);
  posEpaule = constrain(posEpaule, E_MIN, E_MAX);
  posCoude = constrain(posCoude, C_MIN, C_MAX);
  posPoignet = constrain(posPoignet, P_MIN, P_MAX);
  posInc = constrain(posInc, I_MIN, I_MAX);
  posPince = constrain(posPince, G_MIN, G_MAX);
}

void actualiserServos() {
  pwm.setPWM(0, 0, (int)posBase);
  pwm.setPWM(1, 0, (int)posEpaule);
  pwm.setPWM(2, 0, (int)posCoude);
  pwm.setPWM(3, 0, (int)posPoignet);
  pwm.setPWM(4, 0, (int)posInc);
  pwm.setPWM(5, 0, (int)posPince);
}
