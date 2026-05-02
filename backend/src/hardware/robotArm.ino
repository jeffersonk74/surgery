// robotArm.ino
// Code Arduino Uno pour bras robotisé téléchirurgical
// 6 servomoteurs sur pins 3, 5, 6, 9, 10, 11

#include <Servo.h>

Servo servoX, servoY, servoZ, servoR, servoP, servoYaw;

const int PIN_X = 3;
const int PIN_Y = 5;
const int PIN_Z = 6;
const int PIN_R = 9;
const int PIN_P = 10;
const int PIN_YAW = 11;

const int MIN_ANGLE = 0;
const int MAX_ANGLE = 180;

char buffer[64];
int idx = 0;

void setup() {
  Serial.begin(115200);
  
  servoX.attach(PIN_X);
  servoY.attach(PIN_Y);
  servoZ.attach(PIN_Z);
  servoR.attach(PIN_R);
  servoP.attach(PIN_P);
  servoYaw.attach(PIN_YAW);
  
  // Position initiale sécurisée
  setAllServos(90, 90, 90, 0, 0, 0);
  
  Serial.println("[ROBOT] Pret - Attente de commandes...");
}

void loop() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    
    if (c == '\n' || idx >= 63) {
      buffer[idx] = '\0';
      processCommand(buffer);
      idx = 0;
    } else {
      buffer[idx++] = c;
    }
  }
}

void processCommand(char* cmd) {
  int x, y, z, r, p, yaw;
  
  // Parsing rapide avec sscanf
  int parsed = sscanf(cmd, "X:%d,Y:%d,Z:%d,R:%d,P:%d,Y:%d", &x, &y, &z, &r, &p, &yaw);
  
  if (parsed == 6) {
    // Protection limites 0-180°
    x = constrain(x, MIN_ANGLE, MAX_ANGLE);
    y = constrain(y, MIN_ANGLE, MAX_ANGLE);
    z = constrain(z, MIN_ANGLE, MAX_ANGLE);
    r = constrain(r, MIN_ANGLE, MAX_ANGLE);
    p = constrain(p, MIN_ANGLE, MAX_ANGLE);
    yaw = constrain(yaw, MIN_ANGLE, MAX_ANGLE);
    
    setAllServos(x, y, z, r, p, yaw);
    
    // ACK rapide
    Serial.print("[ACK] Position: X=");
    Serial.print(x);
    Serial.print(" Y=");
    Serial.print(y);
    Serial.print(" Z=");
    Serial.println(z);
  } else {
    Serial.print("[ERR] Format invalide: ");
    Serial.println(cmd);
  }
}

void setAllServos(int x, int y, int z, int r, int p, int yaw) {
  servoX.write(x);
  servoY.write(y);
  servoZ.write(z);
  servoR.write(r);
  servoP.write(p);
  servoYaw.write(yaw);
}
