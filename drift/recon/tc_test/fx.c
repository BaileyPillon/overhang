#include <stdint.h>
#include <stdio.h>
#ifdef _WIN32
#define EXP __declspec(dllexport)
#else
#define EXP
#endif
static int16_t sat16(int32_t x){return x>32767?32767:x<-32768?-32768:(int16_t)x;}
EXP int16_t q15_mul(int16_t a,int16_t b){return sat16(((int32_t)a*b+(1<<14))>>15);}
EXP int32_t sum_abs(const int16_t*p,int n){int32_t s=0;for(int i=0;i<n;i++)s+=p[i]<0?-p[i]:p[i];return s;}
#ifdef MAIN
int main(void){printf("q15 0.5*0.5=%d sat=%d\n",q15_mul(16384,16384),q15_mul(-32768,-32768));return 0;}
#endif
