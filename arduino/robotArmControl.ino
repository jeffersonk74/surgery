#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver();

// --- LIMITES ET POSITIONS INITIALES ---
float posBase = 430.0;      const int B_MIN = 200; const int B_MAX = 660;
float posEpaule = 650.0;    const int E_MIN = 500; const int E_MAX = 800; 
float posCoude = 500.0;     const int C_MIN = 400; const int C_MAX = 630;
float posPoignet = 100.0;   const int P_MIN = 100; const int P_MAX = 500;
float posInc = 250.0;       const int I_MIN = 200; const int I_MAX = 550;
float posPince = 270.0;     const int G_MIN = 150; const int G_MAX = 270;

// --- CONFIGURATION DES PINS ---
const int J2_X = A0; const int J2_Y = A1; 
const int J1_X = A2; const int J1_Y = A3; 
const int J1_SW = 2;    
const int J2_SW = 6;    
const int J3_OPEN = 5;  
const int J3_CLOSE = 3; 
const int LED_PIN = 13; // Témoin de synchro 5G/Serveur

float SENSIBILITE = 12; 
const int ZONE_STABLE = 85; 

// Timer pour envoi périodique des positions (toutes les 100ms)
unsigned long lastPosReport = 0;
const unsigned long POS_REPORT_INTERVAL = 100; // ms

void setup() {
  Serial.begin(115200); 
  pwm.begin();
  pwm.setPWMFreq(60); 
  
  pinMode(LED_PIN, OUTPUT);
  pinMode(J1_SW, INPUT_PULLUP);
  pinMode(J2_SW, INPUT_PULLUP);
  pinMode(J3_OPEN, INPUT_PULLUP);
  pinMode(J3_CLOSE, INPUT_PULLUP);

  actualiserServos();
  Serial.println("SYSTEM_READY");
  
  // Envoi initial des positions
  sendPositions();
}

void loop() {
  bool aBouge = false;

  // 1. LECTURE DES COMMANDES SÉRIE (WEB/REMOTE)
  if (Serial.available() > 0) {
    char cmd = Serial.read();
    
    // --- CAS A : ARRÊT D'URGENCE (Signal critique) ---
    if (cmd == 'A') { 
      // Signal visuel : 3 flashs rapides
      for(int i = 0; i < 3; i++) {
        digitalWrite(LED_PIN, HIGH); 
        delay(100);
        digitalWrite(13, LOW); 
        delay(100);
      }
      
      // Sécurité : Retour immédiat aux positions de repos
      posBase = 430; posEpaule = 600; posCoude = 500; 
      posPoignet = 100; posInc = 400; posPince = 270;
      
      actualiserServos();
      sendPositions(); // Envoi immédiat des nouvelles positions
      Serial.println("EMERGENCY_ACK"); // Confirmation pour le serveur
    } 
    
    // --- CAS S : SYNCHRONISATION (Signal normal) ---
    else if (cmd == 'S') { 
      digitalWrite(LED_PIN, HIGH); 
      
      posBase = 430; posEpaule = 600; posCoude = 500; 
      posPoignet = 100; posInc = 400; posPince = 270;
      
      actualiserServos();
      sendPositions(); // Envoi immédiat des nouvelles positions
      delay(800); // Flash long pour différencier de l'arrêt
      digitalWrite(LED_PIN, LOW); 
      Serial.println("SYNC_OK");
    } 
    
    // --- CAS ? : DEMANDE DE POSITIONS ---
    else if (cmd == '?') {
      sendPositions(); // Envoi immédiat des positions actuelles
    }
    
    // --- CAS V : CHANGEMENT DE VITESSE ---
    else if (cmd == 'V') {
      int newSpeed = Serial.parseInt();
      if (newSpeed >= 1 && newSpeed <= 50) {
        SENSIBILITE = newSpeed;
        Serial.print("SPEED_CHANGED ");
        Serial.println((int)SENSIBILITE);
      }
    }
    
    // --- AUTRES COMMANDES (B, E, C, P, I, G) ---
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

  // 3. LECTURE DES COMMANDES DIGITALES (BOUTONS)
  if (digitalRead(J1_SW) == LOW) { posInc += 3.0; aBouge = true; }
  if (digitalRead(J2_SW) == LOW) { posInc -= 3.0; aBouge = true; }
  if (digitalRead(J3_OPEN) == LOW) { posPince += 3.0; aBouge = true; }
  if (digitalRead(J3_CLOSE) == LOW) { posPince -= 3.0; aBouge = true; }

  // 4. ACTUALISATION SI MOUVEMENT
  if (aBouge) {
    contraindrePositions();
    actualiserServos();
  }
  
  // 5. ENVOI PÉRIODIQUE DES POSITIONS (toutes les 100ms)
  unsigned long now = millis();
  if (now - lastPosReport >= POS_REPORT_INTERVAL) {
    sendPositions();
    lastPosReport = now;
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

// Envoi des positions réelles au format: POS base epaule coude poignet inc pince
void sendPositions() {
  Serial.print("POS ");
  Serial.print((int)posBase);
  Serial.print(" ");
  Serial.print((int)posEpaule);
  Serial.print(" ");
  Serial.print((int)posCoude);
  Serial.print(" ");
  Serial.print((int)posPoignet);
  Serial.print(" ");
  Serial.print((int)posInc);
  Serial.print(" ");
  Serial.println((int)posPince);
}
