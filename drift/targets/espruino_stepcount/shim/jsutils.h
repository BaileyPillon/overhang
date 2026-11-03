/* Drift shim: replaces Espruino's jsutils.h. Stepcount only needs int_sqrt32().
   Copied verbatim from gfwilliams/step-count jsutils.h (itself the Espruino function). */
#ifndef DRIFT_JSUTILS_H
#define DRIFT_JSUTILS_H
static unsigned short int int_sqrt32(unsigned int x) {
  unsigned short int res=0;
  unsigned short int add= 0x8000;
  int i;
  for(i=0;i<16;i++) {
    unsigned short int temp=res | add;
    unsigned int g2=temp*temp;
    if (x>=g2)
      res=temp;
    add>>=1;
  }
  return res;
}
#endif
