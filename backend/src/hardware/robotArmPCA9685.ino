// robotArmPCA9685.ino
// Code Arduino Mega pour bras robotisé avec module PCA9685 (I2C)
// 6 servomoteurs sur ports 0-5 du PCA9685 @ 0x40, 50Hz

#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

// Instance PCA9685 @ adresse I2C 0x40
Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

// Configuration PWM 50Hz (standard servos)
const int PWM_FREQ = 50;

// Plage des ticks PWM pour angle 0-180°
const int SERVO_MIN = 150;  // ~0°
const int SERVO_MAX = 600;  // ~180°

// Mapping des 6 servos sur ports PCA9685
const int SERVO_X = 0;
const int SERVO_Y = 1;
const int SERVO_Z = 2;
const int SERVO_R = 3;
const int SERVO_P = 4;
const int SERVO_YAW = 5;

const int MIN_ANGLE = 0;
const int MAX_ANGLE = 180;

char buffer[64];
int idx = 0;

void setup() {
  Serial.begin(115200);
  
  // Initialisation I2C et PCA9685
  Wire.begin();
  pwm.begin();
  pwm.setPWMFreq(PWM_FREQ);
  
  // Position initiale sécurisée (tous les servos à 90° sauf R,P,Y à 0°)
  setAllServos(90, 90, 90, 0, 0, 0);
  
  Serial.println("[ROBOT] PCA9685 Pret - Attente de commandes...");
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
  
  // Parsing rapide avec sscanf (format: X:120,Y:90,Z:45,R:0,P:0,Y:0)
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
    Serial.print("[ACK] PCA9685 Position: X=");
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

// Conversion angle -> ticks PWM et envoi au PCA9685
void setServo(int servoNum, int angle) {
  // Map 0-180° vers SERVO_MIN-SERVO_MAX ticks
  int ticks = map(angle, 0, 180, SERVO_MIN, SERVO_MAX);
  pwm.setPWM(servoNum, 0, ticks);
}

void setAllServos(int x, int y, int z, int r, int p, int yaw) {
  setServo(SERVO_X, x);
  setServo(SERVO_Y, y);
  setServo(SERVO_Z, z);
  setServo(SERVO_R, r);
  setServo(SERVO_P, p);
  setServo(SERVO_YAW, yaw);
}
